import React, { useEffect, useMemo, useRef, useState } from 'react';

// Session Log MVP Scaffold (FlowNote-style, D&D themed)
// Updates in this version:
// 1) Book + Chapter titles: tap opens, tap-and-hold enters inline rename mode.
//    - In rename mode, a small trash button appears on the side.
//    - Delete ALWAYS asks for confirmation.
// 2) Top-right ✧ button in Chapter Reader is now "Notes + Search":
//    - Shows a summary of annotations (notes/comments only; not highlights).
//    - Adds a unified search that searches BOTH transcript + annotations.
//    - Search results can jump you to the match (and highlight it in the transcript).
// 3) Removed rename pencil buttons for titles (rename is long-press).
// 4) Removed window.__renameTarget usage; all title editing is inline state-driven.

// ---------- Types ----------
type Screen =
  | { name: 'home' }
  | { name: 'book'; bookId: string }
  | { name: 'chapter'; bookId: string; chapterId: string };

type Book = {
  id: string;
  title: string;
  color: string;
  updatedAt: number;
  chapters: Chapter[];
};

type Annotation = {
  id: string;
  createdAt: number;
  quote?: string; // optional quoted snippet
  note: string; // user's note/comment
  imageUrls: string[]; // object URLs
};
type HighlightColor =
  | 'pink'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple';

type Highlight = {
  id: string;
  createdAt: number;
  color: HighlightColor;
  start: number; // where highlight starts in the transcript
  end: number; // where highlight ends
  anchor: {
    text: string;
    prefix?: string;
    suffix?: string;
  };
};

type Chapter = {
  id: string;
  index: number;
  createdAt: number;
  title: string;
  transcript: string;
  highlights?: Highlight[]; // <-- ADD THIS LINE
  notesBullets: string[];
  audioUrls?: string[];
  annotations?: Annotation[];
};

type ChatMessage = {
  id: string;
  role: 'user' | 'ai';
  text: string;
  ts: number;
};

type RecordMode = 'append' | 'new';

type PendingDelete =
  | { kind: 'book'; bookId: string }
  | { kind: 'chapter'; bookId: string; chapterId: string }
  | null;

type SearchHit =
  | {
      kind: 'transcript';
      id: string;
      sourceId: string; // chapterId
      index: number;
      preview: string;
      needle: string;
    }
  | {
      kind: 'annotation';
      id: string; // annotation id
      sourceId: string; // chapterId
      preview: string;
      needle: string; // note text or quote used as needle
    };

// ---------- Theme ----------
const APP_BG = '#420201';
const HIGHLIGHT_SWATCHES: { key: HighlightColor; bg: string }[] = [
  { key: 'pink', bg: 'rgba(255, 182, 193, 0.55)' },
  { key: 'orange', bg: 'rgba(255, 200, 140, 0.55)' },
  { key: 'yellow', bg: 'rgba(255, 245, 157, 0.65)' },
  { key: 'green', bg: 'rgba(180, 255, 200, 0.55)' },
  { key: 'blue', bg: 'rgba(170, 210, 255, 0.55)' },
  { key: 'purple', bg: 'rgba(210, 190, 255, 0.55)' },
];

// ---------- Utils ----------
const MAX_IMAGES_PER_ANNOTATION = 3;
function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function formatDate(ts: number) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatChapterAuto(index: number, ts: number) {
  const d = new Date(ts);
  const mm = d.toLocaleDateString(undefined, { month: 'short' });
  const dd = d.getDate().toString().padStart(2, '0');
  return `Chapter ${index} — ${mm} ${dd}`;
}

function cleanTranscript(text: string) {
  return (
    text
      .replace(/…\n?/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim() || '(No transcript captured.)'
  );
}

function randomBookColor() {
  const colors = [
    '#6b0f12',
    '#2b2b2f',
    '#4b1d1f',
    '#1f3a3d',
    '#3a1f2f',
    '#4a3a1f',
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function makePreview(text: string, startIndex: number, needleLen: number) {
  const radius = 44;
  const a = clamp(startIndex - radius, 0, text.length);
  const b = clamp(startIndex + needleLen + radius, 0, text.length);
  const leftEll = a > 0 ? '…' : '';
  const rightEll = b < text.length ? '…' : '';
  return `${leftEll}${text.slice(a, b)}${rightEll}`;
}

function normalize(s: string) {
  return s.trim().replace(/\s+/g, ' ');
}
function reconcileHighlightsAfterEdit(
  oldText: string,
  newText: string,
  oldHighlights: Highlight[]
): Highlight[] {
  const oldLen = oldText.length;
  const newLen = newText.length;

  // common prefix
  let p = 0;
  while (p < oldLen && p < newLen && oldText[p] === newText[p]) p++;

  // common suffix (don’t cross prefix)
  let s = 0;
  while (
    s < oldLen - p &&
    s < newLen - p &&
    oldText[oldLen - 1 - s] === newText[newLen - 1 - s]
  ) {
    s++;
  }

  const oldMidStart = p;
  const oldMidEnd = oldLen - s;
  const newMidStart = p;
  const newMidEnd = newLen - s;

  const delta = newMidEnd - newMidStart - (oldMidEnd - oldMidStart);

  function shiftIndex(i: number) {
    if (i <= oldMidStart) return i; // before change
    if (i >= oldMidEnd) return i + delta; // after change

    // inside changed block → clamp into new changed block
    const rel = i - oldMidStart;
    return clamp(newMidStart + rel, newMidStart, newMidEnd);
  }

  const shifted = (oldHighlights || []).map((h) => {
    const ns = shiftIndex(h.start);
    const ne = shiftIndex(h.end);

    const start = clamp(Math.min(ns, ne), 0, newLen);
    const end = clamp(Math.max(ns, ne), 0, newLen);

    if (end <= start) return null;

    return {
      ...h,
      start,
      end,
      anchor: {
        text: newText.slice(start, end),
        prefix: newText.slice(Math.max(0, start - 16), start),
        suffix: newText.slice(end, Math.min(newLen, end + 16)),
      },
    } as Highlight;
  });

  // drop nulls
  return shifted.filter(Boolean) as Highlight[];
}

function useLongPress(opts: {
  onLongPress: () => void;
  onClick?: () => void;
  enabled?: boolean;
  delayMs?: number;
}) {
  const { onLongPress, onClick, enabled = true, delayMs = 420 } = opts;
  const timerRef = useRef<number | null>(null);
  const firedRef = useRef(false);

  function clear() {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (!enabled) return;
      firedRef.current = false;
      clear();
      // only left click / touch / pen
      if ((e as any).button != null && (e as any).button !== 0) return;
      timerRef.current = window.setTimeout(() => {
        firedRef.current = true;
        onLongPress();
      }, delayMs);
    },
    onPointerUp: () => {
      if (!enabled) return;
      const fired = firedRef.current;
      clear();
      if (!fired && onClick) onClick();
      firedRef.current = false;
    },
    onPointerCancel: () => {
      clear();
      firedRef.current = false;
    },
    onPointerLeave: () => {
      clear();
      // don't auto reset firedRef here; pointerleave can happen mid-longpress
    },
  };

  return handlers;
}

// ---------- UI helpers ----------
function iconBtn(fg = '#f5f5f5', bg = 'rgba(255,255,255,0.10)') {
  return {
    width: 36,
    height: 36,
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.12)',
    background: bg,
    color: fg,
    cursor: 'pointer',
    fontWeight: 900,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    userSelect: 'none',
  } as React.CSSProperties;
}

function navBtn() {
  return {
    width: 46,
    height: 46,
    borderRadius: 14,
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(255,255,255,0.08)',
    color: '#fff',
    fontSize: 18,
    cursor: 'pointer',
    fontWeight: 900,
    userSelect: 'none',
  } as React.CSSProperties;
}

function recordBtn() {
  return {
    width: 54,
    height: 54,
    borderRadius: 18,
    border: '1px solid rgba(255,255,255,0.18)',
    background: 'rgba(255,255,255,0.14)',
    color: '#fff',
    fontSize: 20,
    cursor: 'pointer',
    fontWeight: 900,
    boxShadow: '0 10px 24px rgba(0,0,0,0.30)',
    userSelect: 'none',
  } as React.CSSProperties;
}

function primaryBtn() {
  return {
    padding: '12px 14px',
    borderRadius: 14,
    border: '1px solid rgba(255,255,255,0.16)',
    background: '#111',
    color: '#fff',
    fontWeight: 900,
    cursor: 'pointer',
    userSelect: 'none',
  } as React.CSSProperties;
}

function ghostBtn() {
  return {
    padding: '12px 14px',
    borderRadius: 14,
    border: '1px solid rgba(255,255,255,0.16)',
    background: 'transparent',
    color: '#fff',
    fontWeight: 900,
    cursor: 'pointer',
    userSelect: 'none',
  } as React.CSSProperties;
}

function inputStyle(color: string, bg: string) {
  return {
    width: '100%',
    padding: '12px 12px',
    borderRadius: 14,
    border: '1px solid rgba(0,0,0,0.20)',
    background: bg,
    color,
    outline: 'none',
  } as React.CSSProperties;
}

// ---------- App ----------
export default function App() {
  // Theme slider: 0 = white, 100 = black
  const [themeLevel, setThemeLevel] = useState(92);
  const paperBg = useMemo(() => {
    const v = Math.round((100 - themeLevel) * 2.55);
    return `rgb(${v},${v},${v})`;
  }, [themeLevel]);
  const paperFg = useMemo(
    () => (themeLevel > 55 ? '#f5f5f5' : '#111'),
    [themeLevel]
  );

  const [screen, setScreen] = useState<Screen>({ name: 'home' });

  const [books, setBooks] = useState<Book[]>(() => {
    const now = Date.now();
    const demoBookId = uid('book');

    const ch1: Chapter = {
      id: uid('ch'),
      index: 1,
      createdAt: now - 1000 * 60 * 60 * 24 * 7,
      title: formatChapterAuto(1, now - 1000 * 60 * 60 * 24 * 7),
      transcript:
        'DM: The tavern is loud. A hooded figure watches you from the corner.\n\nKira: I walk up and ask what they want.\n\nThorn: I keep my hand near my blade.\n\nDM: They slide a sealed letter across the table...',
      highlights: [],
      notesBullets: [
        'Party meets a hooded figure in a tavern.',
        'A sealed letter reveals a job offer.',
        'They agree to travel at dawn.',
      ],
      audioUrls: [],
      annotations: [
        {
          id: uid('ann'),
          createdAt: now - 1000 * 60 * 60 * 24 * 6,
          quote: 'They slide a sealed letter across the table...',
          note: 'This is the hook. I should foreshadow who sent it.',
          imageUrls: [],
        },
      ],
    };

    const ch2: Chapter = {
      id: uid('ch'),
      index: 2,
      createdAt: now - 1000 * 60 * 60 * 24 * 3,
      title: formatChapterAuto(2, now - 1000 * 60 * 60 * 24 * 3),
      transcript:
        'DM: The forest closes in. You hear wolves.\n\nKira: I cast Light.\n\nThorn: I scout ahead.\n\nDM: You find claw marks on the trees...',
      highlights: [],
      notesBullets: [
        'Travel begins; wolves stalk the party.',
        'Light spell reveals claw marks.',
        'They set up camp cautiously.',
      ],
      audioUrls: [],
      annotations: [],
    };

    const demoBook: Book = {
      id: demoBookId,
      title: 'Adventure 1',
      color: '#6b0f12',
      updatedAt: now - 1000 * 60 * 60 * 24 * 3,
      chapters: [ch2, ch1],
    };

    return [demoBook];
  });

  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const activeBook = useMemo(
    () => books.find((b) => b.id === activeBookId) || null,
    [books, activeBookId]
  );

  // Drawers
  const [chatOpen, setChatOpen] = useState(false);
  const [playOpen, setPlayOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  // Chat per book (MVP in-memory)
  const [chats, setChats] = useState<Record<string, ChatMessage[]>>({});
  // Oracle "waiting for you to pick a number" memory (per book)
  const oraclePendingRef = useRef<
    Record<
      string,
      {
        queryRaw: string;
        queryNorm: string;
        options: Array<{
          chapterId: string;
          chapterIndex: number;
          chapterTitle: string;
        }>;
      }
    >
  >({});

  // Modal: New Book
  const [newBookOpen, setNewBookOpen] = useState(false);
  const [newBookTitle, setNewBookTitle] = useState('');

  // Deletion confirm modal
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);

  // Inline editing state (book + chapter)
  const [editingTitle, setEditingTitle] = useState<
    | { kind: 'book'; bookId: string; draft: string }
    | { kind: 'chapter'; bookId: string; chapterId: string; draft: string }
    | null
  >(null);

  // ---------- Add Comment popup state ----------
  const [commentPopup, setCommentPopup] = useState<null | {
    bookId: string;
    chapterId: string;
    quote: string;
    start: number;
    end: number;
    rect: { left: number; top: number; width: number; height: number };
  }>(null);

  const [commentDraft, setCommentDraft] = useState('');
  const [commentImages, setCommentImages] = useState<string[]>([]);
  const commentFileRef = useRef<HTMLInputElement | null>(null);

  // Reset draft whenever a new popup opens
  useEffect(() => {
    if (!commentPopup) return;
    setCommentDraft('');
    setCommentImages([]);
  }, [commentPopup?.chapterId, commentPopup?.start, commentPopup?.end]);

  function closeCommentPopupAndCleanupImages() {
    // if the user cancels, we should revoke object urls so we don't leak memory
    commentImages.forEach((u) => {
      try {
        URL.revokeObjectURL(u);
      } catch {}
    });
    setCommentPopup(null);
    setCommentDraft('');
    setCommentImages([]);
  }

  // Transcript edit modal (kept)
  const [editOpen, setEditOpen] = useState(false);
  const [editDraft, setEditDraft] = useState('');

  // Recording
  const [isRecording, setIsRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const recTimerRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const speechRef = useRef<any>(null);
  const [recError, setRecError] = useState<string | null>(null);
  const [liveChunks, setLiveChunks] = useState<{ ts: number; text: string }[]>(
    []
  );

  const [recordTarget, setRecordTarget] = useState<{
    bookId: string;
    chapterId?: string;
  } | null>(null);
  const [recordMode, setRecordMode] = useState<RecordMode>('new');

  // Search/jump in transcript
  const [needle, setNeedle] = useState<string>(''); // what to highlight in transcript
  const [needleChapterId, setNeedleChapterId] = useState<string>(''); // ensure needle applies to current chapter
  const [needleNonce, setNeedleNonce] = useState(0); // force re-jump even if same needle

  const currentChapter = useMemo(() => {
    if (screen.name !== 'chapter') return null;
    const b = books.find((x) => x.id === screen.bookId);
    return b?.chapters.find((c) => c.id === screen.chapterId) || null;
  }, [screen, books]);

  useEffect(() => {
    if (screen.name === 'home') {
      setActiveBookId(null);
      setChatOpen(false);
      setPlayOpen(false);
      setNotesOpen(false);
    }
    if (screen.name === 'book' || screen.name === 'chapter') {
      setActiveBookId(screen.bookId);
    }
  }, [screen]);

  // Close inline title editing when navigating
  useEffect(() => {
    setEditingTitle(null);
  }, [screen.name]);

  // ------------------------------------------------------------
  // Highlights: allow MULTIPLE highlights, different colors.
  // ------------------------------------------------------------
  useEffect(() => {
    function onApplyHighlight(e: any) {
      const detail = e.detail || {};
      const { chapterId, start, end, color } = detail;

      if (!chapterId || typeof start !== 'number' || typeof end !== 'number')
        return;

      const chosenColor: HighlightColor = (color as HighlightColor) || 'pink';

      setBooks((prev) =>
        prev.map((b) => ({
          ...b,
          chapters: b.chapters.map((c) => {
            if (c.id !== chapterId) return c;

            const t = c.transcript || '';
            const s = clamp(Math.min(start, end), 0, t.length);
            const e2 = clamp(Math.max(start, end), 0, t.length);
            if (e2 <= s) return c;

            const existing = c.highlights || [];

            // If exact same highlight already exists, do nothing
            const alreadyExists = existing.some(
              (h) => h.start === s && h.end === e2 && h.color === chosenColor
            );
            if (alreadyExists) return c;

            const now = Date.now();

            // Same-color overlaps (inclusive)
            const sameColorOverlaps = existing.filter(
              (h) => h.color === chosenColor && !(h.end <= s || h.start >= e2)
            );

            // Keep everything except same-color overlaps (we merge those)
            const keep = existing.filter((h) => {
              if (h.color !== chosenColor) return true;
              return h.end <= s || h.start >= e2;
            });

            const mergedStart = sameColorOverlaps.length
              ? Math.min(s, ...sameColorOverlaps.map((h) => h.start))
              : s;

            const mergedEnd = sameColorOverlaps.length
              ? Math.max(e2, ...sameColorOverlaps.map((h) => h.end))
              : e2;

            const toAdd: Highlight = {
              id: uid('hl'),
              createdAt: now,
              color: chosenColor,
              start: mergedStart,
              end: mergedEnd,
              anchor: {
                text: t.slice(mergedStart, mergedEnd),
                prefix: t.slice(Math.max(0, mergedStart - 16), mergedStart),
                suffix: t.slice(mergedEnd, Math.min(t.length, mergedEnd + 16)),
              },
            };

            return {
              ...c,
              highlights: [...keep, toAdd].sort((a, b2) => {
                if (a.start !== b2.start) return a.start - b2.start;
                return a.end - b2.end;
              }),
            };
          }),
        }))
      );
    }

    window.addEventListener('apply-highlight', onApplyHighlight as any);
    return () =>
      window.removeEventListener('apply-highlight', onApplyHighlight as any);
  }, []);

  const shell: React.CSSProperties = {
    minHeight: '100vh',
    background: APP_BG,
    color: '#f5f5f5',
    paddingBottom: 72,
  };

  // ---------- Mutations ----------
  function saveBookTitle(bookId: string, title: string) {
    const t = title.trim();
    if (!t) return;
    const now = Date.now();
    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId ? { ...b, title: t, updatedAt: now } : b
      )
    );
  }

  function saveChapterTitle(bookId: string, chapterId: string, title: string) {
    const t = title.trim();
    if (!t) return;
    const now = Date.now();
    setBooks((prev) =>
      prev.map((b) =>
        b.id !== bookId
          ? b
          : {
              ...b,
              updatedAt: now,
              chapters: b.chapters.map((c) =>
                c.id === chapterId ? { ...c, title: t } : c
              ),
            }
      )
    );
  }

  function addAnnotationToChapter(opts: {
    bookId: string;
    chapterId: string;
    quote: string;
    note: string;
    imageUrls: string[];
  }) {
    const { bookId, chapterId, quote, note, imageUrls } = opts;
    const now = Date.now();

    setBooks((prev) =>
      prev.map((b) => {
        if (b.id !== bookId) return b;
        return {
          ...b,
          updatedAt: now,
          chapters: b.chapters.map((c) => {
            if (c.id !== chapterId) return c;

            const nextAnn: Annotation = {
              id: uid('ann'),
              createdAt: now,
              quote,
              note,
              imageUrls,
            };

            const existing = c.annotations || [];
            return { ...c, annotations: [nextAnn, ...existing] };
          }),
        };
      })
    );
  }

  function confirmDeleteBook(bookId: string) {
    setPendingDelete({ kind: 'book', bookId });
  }

  function confirmDeleteChapter(bookId: string, chapterId: string) {
    setPendingDelete({ kind: 'chapter', bookId, chapterId });
  }

  function doDelete(p: PendingDelete) {
    if (!p) return;

    if (p.kind === 'book') {
      const b = books.find((x) => x.id === p.bookId);
      if (b) {
        b.chapters.forEach((c) => {
          (c.audioUrls || []).forEach((u) => {
            try {
              URL.revokeObjectURL(u);
            } catch {}
          });
          (c.annotations || []).forEach((a) => {
            (a.imageUrls || []).forEach((u) => {
              try {
                URL.revokeObjectURL(u);
              } catch {}
            });
          });
        });
      }

      setBooks((prev) => prev.filter((b2) => b2.id !== p.bookId));
      if (screen.name !== 'home' && screen.bookId === p.bookId)
        setScreen({ name: 'home' });
      setPendingDelete(null);
      setEditingTitle(null);
      return;
    }

    if (p.kind === 'chapter') {
      const b = books.find((x) => x.id === p.bookId);
      const ch = b?.chapters.find((c) => c.id === p.chapterId);
      if (ch) {
        (ch.audioUrls || []).forEach((u) => {
          try {
            URL.revokeObjectURL(u);
          } catch {}
        });
        (ch.annotations || []).forEach((a) => {
          (a.imageUrls || []).forEach((u) => {
            try {
              URL.revokeObjectURL(u);
            } catch {}
          });
        });
      }

      const now = Date.now();
      setBooks((prev) =>
        prev.map((b2) =>
          b2.id !== p.bookId
            ? b2
            : {
                ...b2,
                updatedAt: now,
                chapters: b2.chapters.filter((c) => c.id !== p.chapterId),
              }
        )
      );

      if (screen.name === 'chapter' && screen.chapterId === p.chapterId) {
        setScreen({ name: 'book', bookId: p.bookId });
      }
      setPendingDelete(null);
      setEditingTitle(null);
      return;
    }
  }

  // Delete clip helper
  function deleteClip(chapterId: string, clipIndex: number) {
    if (!activeBookId) return;
    const ok = window.confirm('Delete this audio clip? This cannot be undone.');
    if (!ok) return;

    setBooks((prev) =>
      prev.map((b) => {
        if (b.id !== activeBookId) return b;
        const now = Date.now();
        return {
          ...b,
          updatedAt: now,
          chapters: b.chapters.map((c) => {
            if (c.id !== chapterId) return c;
            const urls = c.audioUrls || [];
            const targetUrl = urls[clipIndex];
            if (targetUrl) {
              try {
                URL.revokeObjectURL(targetUrl);
              } catch {}
            }
            const next = urls.filter((_, i) => i !== clipIndex);
            return { ...c, audioUrls: next };
          }),
        };
      })
    );
  }

  // ---------- Render ----------
  return (
    <div style={shell}>
      <TopBar
        screen={screen}
        books={books}
        activeBookId={activeBookId}
        onBack={() => {
          if (editingTitle) setEditingTitle(null);
          if (screen.name === 'chapter')
            setScreen({ name: 'book', bookId: screen.bookId });
          else if (screen.name === 'book') setScreen({ name: 'home' });
        }}
        onOpenNewBook={() => setNewBookOpen(true)}
      />

      <main style={{ padding: 16 }}>
        {screen.name === 'home' && (
          <HomeBooks
            books={books}
            editingTitle={editingTitle}
            onOpenBook={(bookId) => setScreen({ name: 'book', bookId })}
            onNewBook={() => setNewBookOpen(true)}
            onEnterEdit={(bookId, currentTitle) =>
              setEditingTitle({ kind: 'book', bookId, draft: currentTitle })
            }
            onDraftChange={(v) => {
              if (!editingTitle || editingTitle.kind !== 'book') return;
              setEditingTitle({ ...editingTitle, draft: v });
            }}
            onSave={() => {
              if (!editingTitle || editingTitle.kind !== 'book') return;
              saveBookTitle(editingTitle.bookId, editingTitle.draft);
              setEditingTitle(null);
            }}
            onCancel={() => setEditingTitle(null)}
            onTrash={(bookId) => confirmDeleteBook(bookId)}
          />
        )}

        {screen.name === 'book' && activeBook && (
          <ChaptersGrid
            book={activeBook}
            paperBg={paperBg}
            paperFg={paperFg}
            editingTitle={editingTitle}
            onOpenChapter={(chapterId) =>
              setScreen({ name: 'chapter', bookId: activeBook.id, chapterId })
            }
            onEnterEdit={(chapterId, currentTitle) =>
              setEditingTitle({
                kind: 'chapter',
                bookId: activeBook.id,
                chapterId,
                draft: currentTitle,
              })
            }
            onDraftChange={(v) => {
              if (!editingTitle || editingTitle.kind !== 'chapter') return;
              setEditingTitle({ ...editingTitle, draft: v });
            }}
            onSave={() => {
              if (!editingTitle || editingTitle.kind !== 'chapter') return;
              saveChapterTitle(
                editingTitle.bookId,
                editingTitle.chapterId,
                editingTitle.draft
              );
              setEditingTitle(null);
            }}
            onCancel={() => setEditingTitle(null)}
            onTrash={(chapterId) =>
              confirmDeleteChapter(activeBook.id, chapterId)
            }
          />
        )}

        {screen.name === 'chapter' && activeBook && currentChapter && (
          <ChapterReader
            bookTitle={activeBook.title}
            chapter={currentChapter}
            paperBg={paperBg}
            paperFg={paperFg}
            themeLevel={themeLevel}
            setThemeLevel={setThemeLevel}
            needle={needle}
            needleChapterId={needleChapterId}
            needleNonce={needleNonce}
            onOpenTranscriptEdit={() => {
              setEditDraft(currentChapter.transcript);
              setEditOpen(true);
            }}
            onOpenNotes={() => setNotesOpen(true)}
            onRequestAddComment={(payload) => {
              setCommentPopup({
                bookId: activeBook.id,
                chapterId: currentChapter.id,
                quote: payload.text,
                start: payload.start,
                end: payload.end,
                rect: payload.rect,
              });
            }}
            isTitleEditing={
              editingTitle?.kind === 'chapter' &&
              editingTitle.bookId === activeBook.id &&
              editingTitle.chapterId === currentChapter.id
            }
            titleDraft={
              editingTitle?.kind === 'chapter' &&
              editingTitle.bookId === activeBook.id &&
              editingTitle.chapterId === currentChapter.id
                ? editingTitle.draft
                : currentChapter.title
            }
            onTitleLongPress={() =>
              setEditingTitle({
                kind: 'chapter',
                bookId: activeBook.id,
                chapterId: currentChapter.id,
                draft: currentChapter.title,
              })
            }
            onTitleDraftChange={(v) => {
              if (!editingTitle || editingTitle.kind !== 'chapter') return;
              setEditingTitle({ ...editingTitle, draft: v });
            }}
            onTitleSave={() => {
              if (!editingTitle || editingTitle.kind !== 'chapter') return;
              saveChapterTitle(
                editingTitle.bookId,
                editingTitle.chapterId,
                editingTitle.draft
              );
              setEditingTitle(null);
            }}
            onTitleCancel={() => setEditingTitle(null)}
            onTitleTrash={() =>
              confirmDeleteChapter(activeBook.id, currentChapter.id)
            }
          />
        )}
      </main>

      {!recordOpen && (
        <BottomBar
          onPlay={() => {
            if (!activeBookId) {
              alert('Pick a book first.');
              return;
            }
            if (screen.name !== 'chapter') {
              alert('Open a chapter to play along with its transcript.');
              return;
            }
            setPlayOpen(true);
          }}
          onRecord={() => {
            if (!activeBook) {
              alert('Pick a book first.');
              return;
            }

            setRecError(null);
            setLiveChunks([]);
            audioChunksRef.current = [];
            setRecSeconds(0);

            if (screen.name === 'chapter') {
              setRecordTarget({
                bookId: screen.bookId,
                chapterId: screen.chapterId,
              });
              setRecordMode('append');
            } else {
              setRecordTarget({ bookId: activeBook.id });
              setRecordMode('new');
            }

            setRecordOpen(true);
          }}
          onQuestions={() => {
            if (!activeBookId) {
              alert('Pick a book first.');
              return;
            }
            setChatOpen(true);
          }}
        />
      )}

      {/* Questions (Oracle) */}
      <Drawer
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        title={activeBook ? `Oracle — ${activeBook.title}` : 'Oracle'}
      >
        <QuestionsChat
          book={activeBook}
          messages={activeBook ? chats[activeBook.id] || [] : []}
          onSend={(text) => {
            if (!activeBook) return;

            const userText = text.trim();
            if (!userText) return;

            const bookId = activeBook.id;

            // 1) push the user message
            const msgUser: ChatMessage = {
              id: uid('m'),
              role: 'user',
              text: userText,
              ts: Date.now(),
            };

            // -------- ORACLE HELPERS --------
            function normalizeForSearch(s: string) {
              let out = s.toLowerCase().trim().replace(/\s+/g, ' ');

              // gentle synonyms (matching help only, NOT evidence)
              const swaps: Array<[RegExp, string]> = [
                [/\bforest\b/g, 'woods'],
                [/\bwoods\b/g, 'forest'],
                [/\bbar\b/g, 'tavern'],
                [/\binn\b/g, 'tavern'],
                [/\bpub\b/g, 'tavern'],
                [/\bfight\s*club\b/g, 'fightclub'],
              ];

              for (const [re, rep] of swaps) out = out.replace(re, rep);
              return out;
            }

            function clampLocal(n: number, min: number, max: number) {
              return Math.max(min, Math.min(max, n));
            }

            function previewLine(line: string, qNorm: string) {
              const cleaned = line.replace(/\s+/g, ' ').trim();
              if (!cleaned) return '(No preview)';

              const ln = normalizeForSearch(cleaned);
              const idx = qNorm ? ln.indexOf(qNorm) : -1;

              // if query appears, show around it
              if (idx >= 0) {
                const radius = 42;
                const a = clampLocal(idx - radius, 0, cleaned.length);
                const b = clampLocal(
                  idx + qNorm.length + radius,
                  0,
                  cleaned.length
                );
                const leftEll = a > 0 ? '…' : '';
                const rightEll = b < cleaned.length ? '…' : '';
                return `${leftEll}${cleaned.slice(a, b)}${rightEll}`;
              }

              // otherwise shorten
              return cleaned.length > 110
                ? cleaned.slice(0, 110) + '…'
                : cleaned;
            }

            // Find a “good” line inside a chapter that matches the query
            function bestQuoteFromChapter(transcript: string, qNorm: string) {
              const raw = transcript || '';
              const lines = raw
                .split('\n')
                .map((x) => x.trim())
                .filter(Boolean);

              // best: first line that matches query
              if (qNorm) {
                for (const line of lines) {
                  const ln = normalizeForSearch(line);
                  if (ln.includes(qNorm)) return line;
                }
              }

              // fallback: first DM line
              const dm = lines.find((l) =>
                normalizeForSearch(l).startsWith('dm:')
              );
              if (dm) return dm;

              // fallback fallback: first non-empty line
              return lines[0] || '';
            }

            // Fantasy refusal (oracle vibes, not prophecy)
            const refuse =
              'That lies beyond my record. I can only speak to what has been written in this campaign.';

            // --------- PART A: if oracle is waiting for a number, handle that first ---------
            const pending = oraclePendingRef.current[bookId];

            // If user typed a number AND we have pending options, treat it as a choice.
            const pickedNumber = Number(userText);
            const isWholeNumberChoice =
              pending &&
              Number.isFinite(pickedNumber) &&
              String(pickedNumber) === userText &&
              pickedNumber >= 1 &&
              pickedNumber <= pending.options.length;

            if (isWholeNumberChoice && pending) {
              const picked = pending.options[pickedNumber - 1];

              const chosenChapter = activeBook.chapters.find(
                (c) => c.id === picked.chapterId
              );

              let oracleText = '';
              if (!chosenChapter) {
                oracleText = refuse;
              } else {
                const quote = bestQuoteFromChapter(
                  chosenChapter.transcript || '',
                  pending.queryNorm
                );

                // Your format: answer + chapter cite + 1 sentence
                oracleText =
                  `Very well.\n` +
                  `That can be found in Chapter ${picked.chapterIndex}: “${quote}”`;
              }

              // clear pending, because we used it
              delete oraclePendingRef.current[bookId];

              const msgOracle: ChatMessage = {
                id: uid('m'),
                role: 'ai',
                text: oracleText,
                ts: Date.now(),
              };

              setChats((prev) => ({
                ...prev,
                [bookId]: [...(prev[bookId] || []), msgUser, msgOracle],
              }));

              return; // IMPORTANT: stop here
            }

            // If the oracle was waiting, but the user did NOT pick a number,
            // we throw away the old options and treat this as a new question.
            if (pending) {
              delete oraclePendingRef.current[bookId];
            }

            // --------- PART B: normal question answering (transcripts only) ---------
            const qNorm = normalizeForSearch(userText);

            const matches = activeBook.chapters
              .map((ch) => {
                const t = ch.transcript || '';
                const tNorm = normalizeForSearch(t);

                // score by direct phrase hits
                let score = 0;
                if (qNorm) {
                  let idx = 0;
                  while (idx >= 0) {
                    idx = tNorm.indexOf(qNorm, idx);
                    if (idx === -1) break;
                    score++;
                    idx = idx + Math.max(1, qNorm.length);
                    if (score >= 12) break;
                  }
                }

                // softer matching by keyword tokens if no direct phrase hits
                if (score === 0) {
                  const tokens = qNorm.split(' ').filter(Boolean).slice(0, 6);
                  let tokenScore = 0;
                  for (const tok of tokens) {
                    if (tok.length < 3) continue;
                    if (tNorm.includes(tok)) tokenScore++;
                  }
                  score = tokenScore;
                }

                if (score <= 0) return null;

                const best = bestQuoteFromChapter(t, qNorm);
                return { chapter: ch, score, bestLine: best };
              })
              .filter(Boolean) as Array<{
              chapter: Chapter;
              score: number;
              bestLine: string;
            }>;

            matches.sort(
              (a, b) =>
                b.score - a.score || b.chapter.createdAt - a.chapter.createdAt
            );

            let oracleText = '';

            if (matches.length === 0) {
              oracleText = refuse;
            } else if (matches.length === 1) {
              const m = matches[0];
              const ch = m.chapter;
              const quote = m.bestLine || '(No direct line found.)';

              oracleText =
                `I found it.\n` +
                `That can be found in Chapter ${ch.index}: “${quote}”`;
            } else {
              // MULTI-MATCH: show options WITH clues
              const top = matches.slice(0, 4);

              // store options so user can type "1"
              oraclePendingRef.current[bookId] = {
                queryRaw: userText,
                queryNorm: qNorm,
                options: top.map((m) => ({
                  chapterId: m.chapter.id,
                  chapterIndex: m.chapter.index,
                  chapterTitle: m.chapter.title,
                })),
              };

              const optionLines = top.map((m, i) => {
                const ch = m.chapter;
                const clue = previewLine(m.bestLine || '', qNorm);

                return (
                  `${i + 1}) Chapter ${ch.index} — ${ch.title}\n` +
                  `   “${clue}”`
                );
              });

              oracleText =
                `I found more than one place that fits.\n` +
                `Pick a number (1, 2, 3, …) and I’ll speak of that moment.\n\n` +
                optionLines.join('\n\n');
            }

            const msgOracle: ChatMessage = {
              id: uid('m'),
              role: 'ai',
              text: oracleText,
              ts: Date.now(),
            };

            setChats((prev) => ({
              ...prev,
              [bookId]: [...(prev[bookId] || []), msgUser, msgOracle],
            }));
          }}
        />
      </Drawer>

      {/* Play */}
      <Drawer open={playOpen} onClose={() => setPlayOpen(false)} title="Play">
        <PlayAlong
          chapter={currentChapter}
          paperBg={paperBg}
          paperFg={paperFg}
          onDeleteClip={(clipIndex) => {
            if (!currentChapter) return;
            deleteClip(currentChapter.id, clipIndex);
          }}
        />
      </Drawer>

      {/* Notes + Search (✧) */}
      <Drawer
        open={notesOpen}
        onClose={() => setNotesOpen(false)}
        title={
          currentChapter
            ? `Notes + Search — ${currentChapter.title}`
            : 'Notes + Search'
        }
      >
        <NotesSearchPanel
          chapter={currentChapter}
          onJump={(jumpNeedle) => {
            if (!currentChapter) return;
            const n = normalize(jumpNeedle);
            if (!n) return;
            setNeedle(n);
            setNeedleChapterId(currentChapter.id);
            setNeedleNonce((x) => x + 1);
            setNotesOpen(false);
          }}
        />
      </Drawer>

      {/* Recording */}
      <RecordDrawer
        open={recordOpen}
        onClose={() => {
          stopAllRecording({
            mediaRecorderRef,
            mediaStreamRef,
            speechRef,
            recTimerRef,
            setIsRecording,
            setRecordOpen,
            setRecError,
          });
        }}
        book={activeBook}
        recordMode={recordMode}
        setRecordMode={setRecordMode}
        showAppendOption={screen.name === 'chapter'}
        targetChapterTitle={
          screen.name === 'chapter' && currentChapter
            ? currentChapter.title
            : null
        }
        isRecording={isRecording}
        recSeconds={recSeconds}
        liveText={liveChunks.map((c) => c.text).join('\n')}
        recError={recError}
        onStart={async () => {
          if (!activeBook) return;
          setRecError(null);
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
            });
            mediaStreamRef.current = stream;

            const mr = new MediaRecorder(stream);
            mediaRecorderRef.current = mr;
            audioChunksRef.current = [];
            mr.ondataavailable = (e) => {
              if (e.data && e.data.size > 0)
                audioChunksRef.current.push(e.data);
            };
            mr.start(250);

            const Speech: any =
              (window as any).SpeechRecognition ||
              (window as any).webkitSpeechRecognition;
            if (Speech) {
              const sr = new Speech();
              speechRef.current = sr;
              sr.continuous = true;
              sr.interimResults = true;
              sr.lang = 'en-US';

              sr.onresult = (event: any) => {
                const now = Date.now();
                let interim = '';
                let finals: string[] = [];
                for (let i = event.resultIndex; i < event.results.length; i++) {
                  const res = event.results[i];
                  const txt = res[0]?.transcript || '';
                  if (res.isFinal) finals.push(txt.trim());
                  else interim = txt.trim();
                }

                if (finals.length) {
                  setLiveChunks((prev) => [
                    ...prev,
                    ...finals.map((t) => ({ ts: now, text: t })),
                  ]);
                }
                if (interim) {
                  setLiveChunks((prev) => [
                    ...prev,
                    { ts: now, text: `${interim}…` },
                  ]);
                }
              };

              sr.onerror = () => {};
              sr.start();
            }

            if (recTimerRef.current) window.clearInterval(recTimerRef.current);
            recTimerRef.current = window.setInterval(
              () => setRecSeconds((s) => s + 1),
              1000
            );

            setIsRecording(true);
          } catch (e: any) {
            setRecError(e?.message || 'Mic permission error.');
            stopAllRecording({
              mediaRecorderRef,
              mediaStreamRef,
              speechRef,
              recTimerRef,
              setIsRecording,
              setRecError,
            });
          }
        }}
        onPause={() => {
          try {
            mediaRecorderRef.current?.stop();
          } catch {}
          try {
            speechRef.current?.stop?.();
          } catch {}
          if (recTimerRef.current) {
            window.clearInterval(recTimerRef.current);
            recTimerRef.current = null;
          }
          setIsRecording(false);
        }}
        onResume={async () => {
          try {
            const stream =
              mediaStreamRef.current ||
              (await navigator.mediaDevices.getUserMedia({ audio: true }));
            mediaStreamRef.current = stream;

            const mr = new MediaRecorder(stream);
            mediaRecorderRef.current = mr;
            mr.ondataavailable = (e) => {
              if (e.data && e.data.size > 0)
                audioChunksRef.current.push(e.data);
            };
            mr.start(250);

            const Speech: any =
              (window as any).SpeechRecognition ||
              (window as any).webkitSpeechRecognition;
            if (Speech) {
              const sr = new Speech();
              speechRef.current = sr;
              sr.continuous = true;
              sr.interimResults = true;
              sr.lang = 'en-US';
              sr.onresult = (event: any) => {
                const now = Date.now();
                let interim = '';
                let finals: string[] = [];
                for (let i = event.resultIndex; i < event.results.length; i++) {
                  const res = event.results[i];
                  const txt = res[0]?.transcript || '';
                  if (res.isFinal) finals.push(txt.trim());
                  else interim = txt.trim();
                }
                if (finals.length) {
                  setLiveChunks((prev) => [
                    ...prev,
                    ...finals.map((t) => ({ ts: now, text: t })),
                  ]);
                }
                if (interim) {
                  setLiveChunks((prev) => [
                    ...prev,
                    { ts: now, text: `${interim}…` },
                  ]);
                }
              };
              try {
                sr.start();
              } catch {}
            }

            if (recTimerRef.current) window.clearInterval(recTimerRef.current);
            recTimerRef.current = window.setInterval(
              () => setRecSeconds((s) => s + 1),
              1000
            );

            setIsRecording(true);
          } catch (e: any) {
            setRecError(e?.message || 'Could not resume.');
          }
        }}
        onStop={() => {
          if (!activeBook) return;

          try {
            mediaRecorderRef.current?.stop();
          } catch {}
          try {
            speechRef.current?.stop?.();
          } catch {}
          if (recTimerRef.current) {
            window.clearInterval(recTimerRef.current);
            recTimerRef.current = null;
          }
          setIsRecording(false);

          const now = Date.now();
          const transcriptNew = cleanTranscript(
            liveChunks.map((c) => c.text).join('\n')
          );

          const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          const audioUrl = URL.createObjectURL(blob);

          const target = recordTarget;

          setRecordOpen(false);
          setLiveChunks([]);
          audioChunksRef.current = [];
          setRecSeconds(0);

          // Append to this chapter
          if (recordMode === 'append' && target?.bookId && target.chapterId) {
            setBooks((prev) =>
              prev.map((b) => {
                if (b.id !== target.bookId) return b;
                return {
                  ...b,
                  updatedAt: now,
                  chapters: b.chapters.map((c) => {
                    if (c.id !== target.chapterId) return c;

                    const existingTranscript = (c.transcript || '').trim();
                    const mergedTranscript = existingTranscript
                      ? `${existingTranscript}\n\n${transcriptNew}`
                      : transcriptNew;

                    const existingAudio = c.audioUrls || [];
                    return {
                      ...c,
                      transcript: mergedTranscript,
                      audioUrls: [...existingAudio, audioUrl],
                    };
                  }),
                };
              })
            );

            setScreen({
              name: 'chapter',
              bookId: target.bookId,
              chapterId: target.chapterId,
            });

            stopAllRecording({
              mediaRecorderRef,
              mediaStreamRef,
              speechRef,
              recTimerRef,
              setIsRecording,
              setRecError,
            });
            return;
          }

          // New chapter
          const nextIndex =
            Math.max(
              0,
              ...(activeBook?.chapters || []).map((c) => c.index || 0)
            ) + 1;

          const newChapter: Chapter = {
            id: uid('ch'),
            index: nextIndex,
            createdAt: now,
            title: formatChapterAuto(nextIndex, now),
            transcript: transcriptNew,
            highlights: [],
            notesBullets: ['(AI bullets will appear here after processing.)'],
            audioUrls: [audioUrl],
            annotations: [],
          };

          setBooks((prev) =>
            prev.map((b) =>
              b.id === activeBook.id
                ? {
                    ...b,
                    updatedAt: now,
                    chapters: [newChapter, ...b.chapters],
                  }
                : b
            )
          );

          setScreen({
            name: 'chapter',
            bookId: activeBook.id,
            chapterId: newChapter.id,
          });

          stopAllRecording({
            mediaRecorderRef,
            mediaStreamRef,
            speechRef,
            recTimerRef,
            setIsRecording,
            setRecError,
          });
        }}
      />

      {/* Edit Transcript Modal */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit Transcript"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <textarea
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            rows={14}
            style={{
              width: '100%',
              borderRadius: 12,
              border: '1px solid rgba(0,0,0,0.25)',
              padding: 12,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          />
          <button
            style={primaryBtn()}
            onClick={() => {
              if (screen.name !== 'chapter') return;
              const { bookId, chapterId } = screen;

              setBooks((prev) =>
                prev.map((b) => {
                  if (b.id !== bookId) return b;
                  return {
                    ...b,
                    chapters: b.chapters.map((c) => {
                      if (c.id !== chapterId) return c;

                      const oldText = c.transcript || '';
                      const newText = editDraft;
                      const oldHighlights = c.highlights || [];

                      const nextHighlights = reconcileHighlightsAfterEdit(
                        oldText,
                        newText,
                        oldHighlights
                      );

                      return {
                        ...c,
                        transcript: newText,
                        highlights: nextHighlights,
                      };
                    }),
                  };
                })
              );

              setEditOpen(false);
            }}
          >
            Save
          </button>
        </div>
      </Modal>

      {/* New Book Modal */}
      <Modal
        open={newBookOpen}
        onClose={() => setNewBookOpen(false)}
        title="New Book"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontWeight: 800 }}>Book name</label>
          <input
            value={newBookTitle}
            onChange={(e) => setNewBookTitle(e.target.value)}
            placeholder="e.g. Curse of Strahd"
            style={inputStyle('#111', '#fff')}
          />
          <button
            style={primaryBtn()}
            onClick={() => {
              const title = newBookTitle.trim() || 'New Book';
              const now = Date.now();
              const newBook: Book = {
                id: uid('book'),
                title,
                color: randomBookColor(),
                updatedAt: now,
                chapters: [],
              };
              setBooks((prev) => [newBook, ...prev]);
              setNewBookTitle('');
              setNewBookOpen(false);
            }}
          >
            Create
          </button>
        </div>
      </Modal>

      {/* Confirm Delete Modal */}
      <ConfirmModal
        open={!!pendingDelete}
        title={
          pendingDelete?.kind === 'book' ? 'Delete book?' : 'Delete chapter?'
        }
        body={
          pendingDelete?.kind === 'book'
            ? 'This removes the book and all chapters, audio, and notes. This cannot be undone.'
            : 'This removes the chapter and its audio and notes. This cannot be undone.'
        }
        confirmText="Delete"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => doDelete(pendingDelete)}
      />

      {/* Add Comment Popup (near selected text) */}
      {commentPopup && (
        <div
          style={{
            position: 'fixed',
            left: clamp(
              commentPopup.rect.left + commentPopup.rect.width / 2 - 160,
              12,
              window.innerWidth - 332
            ),
            top: clamp(
              commentPopup.rect.top - 360,
              12,
              window.innerHeight - 120
            ),
            zIndex: 130,
            width: 320,
            maxHeight: '70vh',
            overflow: 'auto',
            background: 'rgba(0,0,0,0.90)',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 16,
            padding: 12,
            boxShadow: '0 18px 42px rgba(0,0,0,0.45)',
            backdropFilter: 'blur(10px)',
            color: '#fff',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 10,
            }}
          >
            <div style={{ fontWeight: 900 }}>Add comment</div>
            <button
              style={iconBtn('#fff', 'rgba(255,255,255,0.10)')}
              onClick={closeCommentPopupAndCleanupImages}
              aria-label="Close comment"
              title="Close"
            >
              ✕
            </button>
          </div>

          <div
            style={{
              marginTop: 10,
              padding: 10,
              borderRadius: 14,
              border: '1px solid rgba(255,255,255,0.10)',
              background: 'rgba(255,255,255,0.06)',
              fontSize: 12,
              lineHeight: '16px',
              opacity: 0.95,
              whiteSpace: 'pre-wrap',
              maxHeight: 90,
              overflow: 'auto',
            }}
            title="Quoted text"
          >
            “{commentPopup.quote}”
          </div>

          <textarea
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            placeholder="Write your note…"
            rows={4}
            style={{
              width: '100%',
              marginTop: 10,
              borderRadius: 14,
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(0,0,0,0.35)',
              color: '#fff',
              padding: 10,
              outline: 'none',
              resize: 'none',
            }}
          />

          {/* Image uploader */}
          <div
            style={{
              marginTop: 10,
              display: 'flex',
              gap: 8,
              alignItems: 'center',
            }}
          >
            <button
              style={{
                ...primaryBtn(),
                padding: '10px 12px',
                background: 'rgba(255,255,255,0.12)',
              }}
              onClick={() => {
                if (commentImages.length >= 3) {
                  alert('Max 3 images per annotation.');
                  return;
                }
                commentFileRef.current?.click();
              }}
            >
              Add image ({commentImages.length}/3)
            </button>

            <input
              ref={commentFileRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                if (!files.length) return;

                setCommentImages((prev) => {
                  const next = [...prev];
                  for (const f of files) {
                    if (next.length >= 3) break;
                    const url = URL.createObjectURL(f);
                    next.push(url);
                  }
                  if (prev.length + files.length > 3)
                    alert('Only 3 images max.');
                  return next;
                });

                e.currentTarget.value = '';
              }}
            />
          </div>

          {commentImages.length > 0 && (
            <div
              style={{
                marginTop: 10,
                display: 'grid',
                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                gap: 8,
              }}
            >
              {commentImages.map((u, idx) => (
                <div key={u} style={{ position: 'relative' }}>
                  <img
                    src={u}
                    alt="comment upload"
                    style={{
                      width: '100%',
                      borderRadius: 14,
                      border: '1px solid rgba(255,255,255,0.10)',
                      objectFit: 'cover',
                      height: 76,
                    }}
                  />
                  <button
                    onClick={() => {
                      setCommentImages((prev) => prev.filter((x) => x !== u));
                      try {
                        URL.revokeObjectURL(u);
                      } catch {}
                    }}
                    title="Remove image"
                    aria-label={`Remove image ${idx + 1}`}
                    style={{
                      position: 'absolute',
                      top: 6,
                      right: 6,
                      width: 26,
                      height: 26,
                      borderRadius: 999,
                      border: '1px solid rgba(255,255,255,0.18)',
                      background: 'rgba(0,0,0,0.65)',
                      color: '#fff',
                      cursor: 'pointer',
                      fontWeight: 900,
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Buttons */}
          <div
            style={{
              marginTop: 12,
              display: 'flex',
              gap: 10,
              justifyContent: 'flex-end',
            }}
          >
            <button
              style={ghostBtn()}
              onClick={closeCommentPopupAndCleanupImages}
            >
              Cancel
            </button>

            <button
              style={primaryBtn()}
              onClick={() => {
                const note = commentDraft.trim();

                if (!note && commentImages.length === 0) {
                  alert('Write a note or add an image.');
                  return;
                }

                addAnnotationToChapter({
                  bookId: commentPopup.bookId,
                  chapterId: commentPopup.chapterId,
                  quote: commentPopup.quote,
                  note: note || '(No text note)',
                  imageUrls: commentImages,
                });

                // IMPORTANT: do NOT revoke urls here.
                // Those urls are now used inside the saved annotation images.
                setCommentPopup(null);
                setCommentDraft('');
                setCommentImages([]);
              }}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Components ----------

function TopBar({
  screen,
  books,
  activeBookId,
  onBack,
  onOpenNewBook,
}: {
  screen: Screen;
  books: Book[];
  activeBookId: string | null;
  onBack: () => void;
  onOpenNewBook: () => void;
}) {
  const title = useMemo(() => {
    if (screen.name === 'home') return 'Session Log';
    const b = books.find((x) => x.id === activeBookId);
    return b?.title || 'Session Log';
  }, [screen, books, activeBookId]);

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 10,
        padding: '14px 16px',
        background: APP_BG,
        borderBottom: '1px solid rgba(255,255,255,0.10)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 80 }}
      >
        {screen.name !== 'home' ? (
          <button style={iconBtn()} onClick={onBack} aria-label="Back">
            ←
          </button>
        ) : (
          <div style={{ width: 36 }} />
        )}
      </div>

      <div
        style={{
          fontWeight: 900,
          letterSpacing: 0.3,
          textAlign: 'center',
          flex: 1,
        }}
      >
        {title}
      </div>

      <div
        style={{ display: 'flex', justifyContent: 'flex-end', minWidth: 80 }}
      >
        {screen.name === 'home' ? (
          <button
            style={iconBtn()}
            onClick={onOpenNewBook}
            aria-label="New Book"
          >
            ＋
          </button>
        ) : (
          <div style={{ width: 36 }} />
        )}
      </div>
    </header>
  );
}

function HomeBooks({
  books,
  editingTitle,
  onOpenBook,
  onNewBook,
  onEnterEdit,
  onDraftChange,
  onSave,
  onCancel,
  onTrash,
}: {
  books: Book[];
  editingTitle:
    | { kind: 'book'; bookId: string; draft: string }
    | { kind: 'chapter'; bookId: string; chapterId: string; draft: string }
    | null;
  onOpenBook: (bookId: string) => void;
  onNewBook: () => void;
  onEnterEdit: (bookId: string, currentTitle: string) => void;
  onDraftChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onTrash: (bookId: string) => void;
}) {
  return (
    <div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 14,
        }}
      >
        {books.map((b) => {
          const isEditing =
            editingTitle?.kind === 'book' && editingTitle.bookId === b.id;

          const lp = useLongPress({
            onLongPress: () => onEnterEdit(b.id, b.title),
            onClick: () => {
              if (isEditing) return;
              onOpenBook(b.id);
            },
            enabled: true,
          });

          return (
            <div
              key={b.id}
              style={{ display: 'flex', flexDirection: 'column' }}
            >
              <div
                {...lp}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: '#f5f5f5',
                  textAlign: 'left',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <div
                  style={{
                    height: 112,
                    borderRadius: 14,
                    background: b.color,
                    border: '1px solid rgba(255,255,255,0.18)',
                    position: 'relative',
                    boxShadow: '0 10px 22px rgba(0,0,0,0.25)',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      right: 12,
                      top: 0,
                      width: 10,
                      height: 46,
                      borderBottomLeftRadius: 8,
                      borderBottomRightRadius: 8,
                      background: 'rgba(255,255,255,0.22)',
                    }}
                  />
                </div>
              </div>

              <div
                style={{
                  marginTop: 8,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                {isEditing ? (
                  <>
                    <input
                      autoFocus
                      value={(editingTitle as any).draft}
                      onChange={(e) => onDraftChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') onSave();
                        if (e.key === 'Escape') onCancel();
                      }}
                      onBlur={onSave}
                      style={{
                        flex: 1,
                        padding: '8px 10px',
                        borderRadius: 12,
                        border: '1px solid rgba(255,255,255,0.14)',
                        background: 'rgba(0,0,0,0.35)',
                        color: '#fff',
                        fontWeight: 900,
                        fontSize: 12,
                      }}
                    />
                    <button
                      style={iconBtn('#fff', 'rgba(255,255,255,0.10)')}
                      onClick={() => onTrash(b.id)}
                      aria-label="Delete book"
                      title="Delete book"
                    >
                      🗑
                    </button>
                  </>
                ) : (
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        fontWeight: 900,
                        fontSize: 13,
                        lineHeight: '16px',
                      }}
                    >
                      {b.title}
                    </div>
                    <div style={{ marginTop: 2, opacity: 0.75, fontSize: 12 }}>
                      Updated {formatDate(b.updatedAt)}
                    </div>
                  </div>
                )}
              </div>

              {!isEditing && (
                <div style={{ opacity: 0.55, fontSize: 11, marginTop: 6 }}>
                  Tip: hold to edit
                </div>
              )}
            </div>
          );
        })}

        <button
          onClick={onNewBook}
          style={{
            border: '2px dashed rgba(255,255,255,0.35)',
            borderRadius: 14,
            height: 112,
            background: 'transparent',
            cursor: 'pointer',
            color: '#f5f5f5',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <div style={{ fontSize: 26, fontWeight: 900 }}>＋</div>
          <div style={{ fontWeight: 900, fontSize: 12, opacity: 0.9 }}>
            Add book
          </div>
        </button>
      </div>
    </div>
  );
}

function ChaptersGrid({
  book,
  onOpenChapter,
  onEnterEdit,
  onDraftChange,
  onSave,
  onCancel,
  onTrash,
  paperBg,
  paperFg,
  editingTitle,
}: {
  book: Book;
  onOpenChapter: (chapterId: string) => void;
  onEnterEdit: (chapterId: string, currentTitle: string) => void;
  onDraftChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onTrash: (chapterId: string) => void;
  paperBg: string;
  paperFg: string;
  editingTitle:
    | { kind: 'book'; bookId: string; draft: string }
    | { kind: 'chapter'; bookId: string; chapterId: string; draft: string }
    | null;
}) {
  const chaptersNewestFirst = useMemo(
    () => [...book.chapters].sort((a, b) => b.createdAt - a.createdAt),
    [book.chapters]
  );

  return (
    <div>
      {chaptersNewestFirst.length === 0 ? (
        <div
          style={{
            padding: 22,
            borderRadius: 18,
            border: '2px dashed rgba(255,255,255,0.35)',
            textAlign: 'center',
            marginTop: 18,
          }}
        >
          <div style={{ fontWeight: 900, fontSize: 16 }}>No chapters yet</div>
          <div style={{ marginTop: 6, opacity: 0.8 }}>
            Tap Record to create Chapter 1.
          </div>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 12,
          }}
        >
          {chaptersNewestFirst.map((c) => {
            const isEditing =
              editingTitle?.kind === 'chapter' &&
              editingTitle.bookId === book.id &&
              editingTitle.chapterId === c.id;

            const lp = useLongPress({
              onLongPress: () => onEnterEdit(c.id, c.title),
              onClick: () => {
                if (isEditing) return;
                onOpenChapter(c.id);
              },
            });

            return (
              <div
                key={c.id}
                style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
              >
                <button
                  {...lp}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    textAlign: 'left',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  <div
                    style={{
                      height: 120,
                      borderRadius: 14,
                      background: paperBg,
                      color: paperFg,
                      border: '1px solid rgba(255,255,255,0.14)',
                      padding: 10,
                      overflow: 'hidden',
                      boxShadow: '0 10px 22px rgba(0,0,0,0.18)',
                    }}
                  >
                    <div
                      style={{ fontSize: 10, opacity: 0.65, marginBottom: 6 }}
                    >
                      {formatDate(c.createdAt)}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        lineHeight: '14px',
                        opacity: 0.95,
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {c.transcript.slice(0, 140)}
                      {c.transcript.length > 140 ? '…' : ''}
                    </div>
                  </div>
                </button>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  {isEditing ? (
                    <>
                      <input
                        autoFocus
                        value={(editingTitle as any).draft}
                        onChange={(e) => onDraftChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') onSave();
                          if (e.key === 'Escape') onCancel();
                        }}
                        onBlur={onSave}
                        style={{
                          flex: 1,
                          padding: '8px 10px',
                          borderRadius: 12,
                          border: '1px solid rgba(255,255,255,0.14)',
                          background: 'rgba(0,0,0,0.35)',
                          color: '#fff',
                          fontWeight: 900,
                          fontSize: 12,
                        }}
                      />
                      <button
                        style={iconBtn('#fff', 'rgba(255,255,255,0.10)')}
                        onClick={() => onTrash(c.id)}
                        aria-label="Delete chapter"
                        title="Delete chapter"
                      >
                        🗑
                      </button>
                    </>
                  ) : (
                    <>
                      <div
                        style={{ fontWeight: 900, fontSize: 12, opacity: 0.95 }}
                      >
                        {c.title}
                      </div>
                      <div style={{ opacity: 0.55, fontSize: 11 }}></div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChapterReader({
  bookTitle,
  chapter,
  paperBg,
  paperFg,
  themeLevel,
  setThemeLevel,
  needle,
  needleChapterId,
  needleNonce,
  onOpenTranscriptEdit,
  onOpenNotes,

  // NEW: this is the “tell App to open the typing popup” button
  onRequestAddComment,

  isTitleEditing,
  titleDraft,
  onTitleLongPress,
  onTitleDraftChange,
  onTitleSave,
  onTitleCancel,
  onTitleTrash,
}: {
  bookTitle: string;
  chapter: Chapter;
  paperBg: string;
  paperFg: string;
  themeLevel: number;
  setThemeLevel: (n: number) => void;
  needle: string;
  needleChapterId: string;
  needleNonce: number;
  onOpenTranscriptEdit: () => void;
  onOpenNotes: () => void;

  onRequestAddComment: (payload: {
    text: string;
    start: number;
    end: number;
    rect: { left: number; top: number; width: number; height: number };
  }) => void;

  isTitleEditing: boolean;
  titleDraft: string;
  onTitleLongPress: () => void;
  onTitleDraftChange: (v: string) => void;
  onTitleSave: () => void;
  onTitleCancel: () => void;
  onTitleTrash: () => void;
}) {
  const [bulletsOpen, setBulletsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fontSize, setFontSize] = useState(15);
  const [lineHeight, setLineHeight] = useState(1.55);

  // This is the “you selected text” popup info
  const [selPopup, setSelPopup] = useState<null | {
    text: string;
    start: number;
    end: number;
    rect: { left: number; top: number; width: number; height: number };
  }>(null);

  const [colorPopupOpen, setColorPopupOpen] = useState(false);

  const transcriptWrapRef = useRef<HTMLDivElement | null>(null);

  const card: React.CSSProperties = {
    borderRadius: 18,
    border: '1px solid rgba(255,255,255,0.14)',
    background: paperBg,
    color: paperFg,
    boxShadow: '0 14px 28px rgba(0,0,0,0.18)',
    overflow: 'hidden',
    position: 'relative',
  };

  const effectiveNeedle =
    needleChapterId === chapter.id ? normalize(needle) : '';

  const highlights = chapter.highlights || [];

  const renderedTranscript = useMemo(() => {
    const txt = chapter.transcript || '';
    const len = txt.length;

    // 1) normalize highlights
    const hs = (highlights || [])
      .map((h) => {
        const s = clamp(h.start, 0, len);
        const e = clamp(h.end, 0, len);
        if (e <= s) return null;
        return { ...h, start: s, end: e };
      })
      .filter(Boolean) as Highlight[];

    // sort: earlier start first; older first
    hs.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });

    // 2) search ranges
    const n = normalize(effectiveNeedle);
    const searchRanges: { start: number; end: number; hit: number }[] = [];
    if (n) {
      const re = new RegExp(escapeRegExp(n), 'ig');
      let hit = 0;
      for (const m of txt.matchAll(re)) {
        const start = m.index ?? 0;
        const end = start + (m[0]?.length || 0);
        if (end > start) {
          searchRanges.push({
            start: clamp(start, 0, len),
            end: clamp(end, 0, len),
            hit,
          });
          hit++;
        }
        if (hit >= 80) break;
      }
    }

    // 3) split boundaries
    const bounds = new Set<number>();
    bounds.add(0);
    bounds.add(len);
    for (const h of hs) {
      bounds.add(h.start);
      bounds.add(h.end);
    }
    for (const r of searchRanges) {
      bounds.add(r.start);
      bounds.add(r.end);
    }
    const points = Array.from(bounds).sort((a, b) => a - b);
    if (points.length <= 2) return <>{txt}</>;

    const bgFor = (c: HighlightColor) =>
      c === 'pink'
        ? 'rgba(255,182,193,0.55)'
        : c === 'orange'
        ? 'rgba(255,200,140,0.55)'
        : c === 'yellow'
        ? 'rgba(255,245,150,0.55)'
        : c === 'green'
        ? 'rgba(170,255,190,0.55)'
        : c === 'blue'
        ? 'rgba(170,210,255,0.55)'
        : 'rgba(220,180,255,0.55)';

    function topHighlightFor(a: number, b: number) {
      const covering = hs.filter((h) => h.start < b && h.end > a);
      if (!covering.length) return null;
      let best = covering[0];
      for (const h of covering) {
        if ((h.createdAt || 0) > (best.createdAt || 0)) best = h;
      }
      return best;
    }

    function searchFor(a: number, b: number) {
      const r = searchRanges.find((x) => x.start < b && x.end > a);
      return r || null;
    }

    const out: React.ReactNode[] = [];

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (b <= a) continue;

      const slice = txt.slice(a, b);
      if (!slice) continue;

      const h = topHighlightFor(a, b);
      const sr = searchFor(a, b);

      let node: React.ReactNode = slice;

      if (sr) {
        node = (
          <mark
            key={`mk_${a}_${b}_${sr.hit}`}
            data-hit={sr.hit}
            style={{
              background: 'rgba(255,215,0,0.35)',
              color: paperFg,
              padding: '0 2px',
              borderRadius: 6,
            }}
          >
            {slice}
          </mark>
        );
      }

      if (h) {
        node = (
          <span
            key={`hl_${a}_${b}_${h.id}`}
            style={{
              background: bgFor(h.color),
              borderRadius: 6,
              padding: '0 2px',
            }}
          >
            {node}
          </span>
        );
      } else {
        node = <React.Fragment key={`tx_${a}_${b}`}>{node}</React.Fragment>;
      }

      out.push(node);
    }

    return <>{out}</>;
  }, [chapter.transcript, highlights, effectiveNeedle, paperFg]);

  useEffect(() => {
    if (!effectiveNeedle) return;
    const _ = needleNonce;

    const t = window.setTimeout(() => {
      const wrap = transcriptWrapRef.current;
      if (!wrap) return;

      const first = wrap.querySelector(
        'mark[data-hit="0"]'
      ) as HTMLElement | null;

      if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      else wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);

    return () => window.clearTimeout(t);
  }, [effectiveNeedle, needleNonce]);

  const titleLongPress = useLongPress({
    onLongPress: onTitleLongPress,
    onClick: () => {},
    enabled: true,
    delayMs: 420,
  });

  return (
    <div>
      {/* top row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          marginBottom: 10,
        }}
      >
        <div style={{ fontWeight: 900, opacity: 0.95 }}>{bookTitle}</div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            style={iconBtn()}
            onClick={() => setBulletsOpen((s) => !s)}
            title="AI bullets"
          >
            ≡
          </button>
          <button
            style={iconBtn()}
            onClick={() => setSettingsOpen((s) => !s)}
            title="Reading settings"
          >
            Aa
          </button>
          <button
            style={iconBtn()}
            onClick={onOpenNotes}
            title="Notes + Search"
          >
            ✧
          </button>
        </div>
      </div>

      {/* bullets */}
      {bulletsOpen && (
        <div
          style={{
            marginBottom: 10,
            padding: 12,
            borderRadius: 14,
            border: '1px solid rgba(255,255,255,0.14)',
            background: 'rgba(0,0,0,0.20)',
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 6 }}>AI bullets</div>
          <ul style={{ margin: 0, paddingLeft: 18, opacity: 0.9 }}>
            {chapter.notesBullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      {/* settings */}
      {settingsOpen && (
        <div
          style={{
            marginBottom: 10,
            padding: 12,
            borderRadius: 14,
            border: '1px solid rgba(255,255,255,0.14)',
            background: 'rgba(0,0,0,0.20)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ fontWeight: 900 }}>Reading settings</div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 10,
            }}
          >
            <div style={{ fontWeight: 800, opacity: 0.9 }}>Theme</div>
            <div style={{ opacity: 0.85, fontSize: 12 }}>white → black</div>
          </div>
          <input
            type="range"
            min={0}
            maxrow
            max={100}
            value={themeLevel}
            onChange={(e) => setThemeLevel(Number(e.target.value))}
          />

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 10,
            }}
          >
            <div style={{ fontWeight: 800, opacity: 0.9 }}>Font size</div>
            <div style={{ opacity: 0.85, fontSize: 12 }}>{fontSize}px</div>
          </div>
          <input
            type="range"
            min={12}
            max={22}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
          />

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 10,
            }}
          >
            <div style={{ fontWeight: 800, opacity: 0.9 }}>Line spacing</div>
            <div style={{ opacity: 0.85, fontSize: 12 }}>
              {lineHeight.toFixed(2)}
            </div>
          </div>
          <input
            type="range"
            min={1.2}
            max={2.0}
            step={0.05}
            value={lineHeight}
            onChange={(e) => setLineHeight(Number(e.target.value))}
          />
        </div>
      )}

      {/* transcript card */}
      <div style={card}>
        <button
          onClick={onOpenTranscriptEdit}
          style={{
            position: 'absolute',
            top: 10,
            right: 10,
            width: 34,
            height: 34,
            borderRadius: 12,
            border: '1px solid rgba(0,0,0,0.16)',
            background: 'rgba(0,0,0,0.06)',
            color: paperFg,
            cursor: 'pointer',
            fontWeight: 900,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          aria-label="Edit transcript"
          title="Edit transcript"
        >
          ✎
        </button>

        <div
          ref={transcriptWrapRef}
          onMouseUp={() => {
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return;

            const range = sel.getRangeAt(0);
            const text = sel.toString();
            if (!text.trim()) {
              setSelPopup(null);
              setColorPopupOpen(false);
              return;
            }

            const wrap = transcriptWrapRef.current;
            if (!wrap) return;

            // find the start index of selection in the transcript
            const pre = document.createRange();
            pre.selectNodeContents(wrap);
            pre.setEnd(range.startContainer, range.startOffset);

            const start = pre.toString().length;
            const end = start + text.length;

            const r = range.getBoundingClientRect();

            setSelPopup({
              text,
              start,
              end,
              rect: {
                left: r.left,
                top: r.top,
                width: r.width,
                height: r.height,
              },
            });
            setColorPopupOpen(false);
          }}
          style={{
            padding: 16,
            fontSize,
            lineHeight,
            whiteSpace: 'pre-wrap',
            fontFamily:
              'ui-serif, Georgia, Cambria, Times New Roman, Times, serif',
            userSelect: 'text',
          }}
          title="Select text"
        >
          {renderedTranscript}
        </div>

        {/* the tiny popup menu */}
        {selPopup && (
          <div
            style={{
              position: 'fixed',
              left: clamp(
                selPopup.rect.left + selPopup.rect.width / 2 - 110,
                12,
                window.innerWidth - 232
              ),
              top: Math.max(12, selPopup.rect.top - 54),
              zIndex: 120,
              background: 'rgba(0,0,0,0.85)',
              border: '1px solid rgba(255,255,255,0.14)',
              borderRadius: 16,
              padding: 8,
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              boxShadow: '0 18px 42px rgba(0,0,0,0.40)',
              backdropFilter: 'blur(10px)',
            }}
          >
            <button
              style={{
                ...primaryBtn(),
                padding: '10px 12px',
                borderRadius: 14,
              }}
              onClick={() => {
                // THIS is the missing wire:
                // tell App to open the typing popup
                onRequestAddComment({
                  text: selPopup.text,
                  start: selPopup.start,
                  end: selPopup.end,
                  rect: selPopup.rect,
                });

                setSelPopup(null);
                setColorPopupOpen(false);

                // optional: clear the selection highlight on the page
                try {
                  window.getSelection()?.removeAllRanges();
                } catch {}
              }}
            >
              Add comment
            </button>

            <button
              style={{
                ...primaryBtn(),
                padding: '10px 12px',
                borderRadius: 14,
                background: 'rgba(255,255,255,0.14)',
              }}
              onClick={() => setColorPopupOpen(true)}
            >
              Highlight
            </button>

            <button
              style={iconBtn('#fff', 'rgba(255,255,255,0.10)')}
              onClick={() => {
                setSelPopup(null);
                setColorPopupOpen(false);
              }}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        )}

        {/* highlight colors popup */}
        {selPopup && colorPopupOpen && (
          <div
            style={{
              position: 'fixed',
              left: clamp(
                selPopup.rect.left + selPopup.rect.width / 2 - 120,
                12,
                window.innerWidth - 252
              ),
              top: Math.max(12, selPopup.rect.top - 6),
              zIndex: 121,
              background: 'rgba(0,0,0,0.90)',
              border: '1px solid rgba(255,255,255,0.14)',
              borderRadius: 16,
              padding: 10,
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              boxShadow: '0 18px 42px rgba(0,0,0,0.40)',
              backdropFilter: 'blur(10px)',
            }}
          >
            {(
              [
                ['pink', 'rgba(255,182,193,0.70)'],
                ['orange', 'rgba(255,200,140,0.70)'],
                ['yellow', 'rgba(255,245,157,0.75)'],
                ['green', 'rgba(180,255,200,0.65)'],
                ['blue', 'rgba(170,210,255,0.70)'],
                ['purple', 'rgba(220,190,255,0.70)'],
              ] as const
            ).map(([name, bg]) => (
              <button
                key={name}
                onClick={() => {
                  window.dispatchEvent(
                    new CustomEvent('apply-highlight', {
                      detail: {
                        chapterId: chapter.id,
                        start: selPopup.start,
                        end: selPopup.end,
                        color: name,
                      },
                    })
                  );
                  setColorPopupOpen(false);
                  setSelPopup(null);
                }}
                title={name}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 999,
                  border: '1px solid rgba(255,255,255,0.22)',
                  background: bg,
                  cursor: 'pointer',
                }}
              />
            ))}

            <button
              style={iconBtn('#fff', 'rgba(255,255,255,0.10)')}
              onClick={() => setColorPopupOpen(false)}
              aria-label="Close colors"
              title="Close"
            >
              ✕
            </button>
          </div>
        )}

        {/* bottom title row */}
        <div
          style={{
            padding: '10px 16px',
            borderTop: '1px solid rgba(0,0,0,0.12)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            opacity: 0.92,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            {isTitleEditing ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => onTitleDraftChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onTitleSave();
                  if (e.key === 'Escape') onTitleCancel();
                }}
                onBlur={onTitleSave}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 12,
                  border: '1px solid rgba(0,0,0,0.16)',
                  background: 'rgba(0,0,0,0.06)',
                  color: paperFg,
                  fontWeight: 900,
                  outline: 'none',
                }}
              />
            ) : (
              <div
                {...titleLongPress}
                style={{
                  fontWeight: 900,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  cursor: 'default',
                  userSelect: 'none',
                }}
                title
              >
                {chapter.title}
              </div>
            )}

            <div style={{ opacity: 0.75, fontSize: 12, marginTop: 2 }}>
              {formatDate(chapter.createdAt)}
            </div>
          </div>

          {isTitleEditing ? (
            <button
              style={{
                ...iconBtn(paperFg, 'rgba(0,0,0,0.06)'),
                border: '1px solid rgba(0,0,0,0.16)',
              }}
              onClick={onTitleTrash}
              aria-label="Delete chapter"
              title="Delete chapter"
            >
              🗑
            </button>
          ) : null}
        </div>
      </div>

      <div style={{ marginTop: 10, opacity: 0.75, fontSize: 12 }}>
        Tip: ✧ is your notes summary + search.
      </div>
    </div>
  );
}

function BottomBar({
  onPlay,
  onRecord,
  onQuestions,
}: {
  onPlay: () => void;
  onRecord: () => void;
  onQuestions: () => void;
}) {
  return (
    <nav
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        height: 60,
        background: 'rgba(0,0,0,0.40)',
        backdropFilter: 'blur(10px)',
        borderTop: '1px solid rgba(255,255,255,0.12)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-around',
        paddingBottom: 'env(safe-area-inset-bottom)',
        zIndex: 60,
      }}
    >
      <button style={navBtn()} onClick={onPlay} aria-label="Play">
        ▶︎
      </button>
      <button style={recordBtn()} onClick={onRecord} aria-label="Record">
        ●
      </button>
      <button style={navBtn()} onClick={onQuestions} aria-label="Questions">
        💬
      </button>
    </nav>
  );
}

function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 80,
      }}
      onClick={onClose}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: '86vh',
          background: '#111',
          borderTopLeftRadius: 18,
          borderTopRightRadius: 18,
          borderTop: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 -18px 40px rgba(0,0,0,0.45)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: '12px 14px',
            borderBottom: '1px solid rgba(255,255,255,0.10)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <div style={{ fontWeight: 900 }}>{title}</div>
          <button style={iconBtn()} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div style={{ padding: 14, overflow: 'auto', flex: 1 }}>{children}</div>
      </div>
    </div>
  );
}

function NotesSearchPanel({
  chapter,
  onJump,
}: {
  chapter: Chapter | null;
  onJump: (needle: string) => void;
}) {
  const [q, setQ] = useState('');

  useEffect(() => {
    setQ('');
  }, [chapter?.id]);

  if (!chapter)
    return (
      <div style={{ opacity: 0.85 }}>
        Open a chapter to view notes + search.
      </div>
    );

  const anns = chapter.annotations || [];
  const query = normalize(q);

  const hits = useMemo<SearchHit[]>(() => {
    if (!query) return [];
    const out: SearchHit[] = [];

    // transcript hits
    const txt = chapter.transcript || '';
    const re = new RegExp(escapeRegExp(query), 'ig');
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = re.exec(txt)) && count < 30) {
      const idx = m.index ?? 0;
      out.push({
        kind: 'transcript',
        id: `t_${idx}_${count}`,
        sourceId: chapter.id,
        index: idx,
        preview: makePreview(txt, idx, query.length),
        needle: query,
      });
      count++;
    }

    // annotation hits (note + quote)
    anns.forEach((a) => {
      const noteText = a.note || '';
      const quoteText = a.quote || '';
      const combined = `${quoteText}\n${noteText}`.toLowerCase();
      if (combined.includes(query.toLowerCase())) {
        out.push({
          kind: 'annotation',
          id: a.id,
          sourceId: chapter.id,
          preview: a.quote ? `“${a.quote}”\n${a.note}` : a.note,
          needle: a.quote && a.quote.trim() ? a.quote.trim() : query,
        });
      }
    });

    return out;
  }, [query, chapter.id, chapter.transcript, anns]);

  const notesSummary = useMemo(() => {
    const list = [...anns].sort((a, b) => b.createdAt - a.createdAt);
    return list;
  }, [anns]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Search */}
      <div
        style={{
          borderRadius: 16,
          border: '1px solid rgba(255,255,255,0.12)',
          background: 'rgba(255,255,255,0.06)',
          padding: 12,
        }}
      >
        <div style={{ fontWeight: 900, marginBottom: 8 }}>
          Search transcript + notes
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search… (NPC name, item, location, rule, etc.)"
          style={{
            width: '100%',
            padding: '12px 12px',
            borderRadius: 14,
            border: '1px solid rgba(255,255,255,0.14)',
            background: 'rgba(0,0,0,0.35)',
            color: '#fff',
            outline: 'none',
          }}
        />

        {query ? (
          <div
            style={{
              marginTop: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ opacity: 0.8, fontSize: 12 }}>
              {hits.length ? `${hits.length} match(es)` : 'No matches'}
            </div>

            {hits.slice(0, 20).map((h) => (
              <button
                key={`${h.kind}_${h.id}`}
                onClick={() => onJump(h.needle)}
                style={{
                  textAlign: 'left',
                  border: '1px solid rgba(255,255,255,0.10)',
                  background: 'rgba(0,0,0,0.25)',
                  color: '#fff',
                  borderRadius: 14,
                  padding: 10,
                  cursor: 'pointer',
                  whiteSpace: 'pre-wrap',
                  lineHeight: '18px',
                }}
              >
                <div
                  style={{
                    fontWeight: 900,
                    fontSize: 12,
                    opacity: 0.85,
                    marginBottom: 6,
                  }}
                >
                  {h.kind === 'transcript' ? 'In transcript' : 'In your notes'}
                </div>
                <div style={{ opacity: 0.92 }}>{h.preview}</div>
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.65 }}>
                  Tap to jump & highlight
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>
            Type to find something fast — this searches both the transcript and
            your notes.
          </div>
        )}
      </div>

      {/* Notes summary */}
      <div
        style={{
          borderRadius: 16,
          border: '1px solid rgba(255,255,255,0.12)',
          background: 'rgba(255,255,255,0.06)',
          padding: 12,
        }}
      >
        <div style={{ fontWeight: 900, marginBottom: 8 }}>Your annotations</div>

        {notesSummary.length === 0 ? (
          <div style={{ opacity: 0.8, fontSize: 13 }}>
            No annotations yet. (Later: selecting text will let you add comments
            Wattpad-style.)
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {notesSummary.map((a) => (
              <button
                key={a.id}
                onClick={() => onJump(a.quote?.trim() || a.note)}
                style={{
                  textAlign: 'left',
                  border: '1px solid rgba(255,255,255,0.10)',
                  background: 'rgba(0,0,0,0.25)',
                  color: '#fff',
                  borderRadius: 14,
                  padding: 10,
                  cursor: 'pointer',
                  whiteSpace: 'pre-wrap',
                  lineHeight: '18px',
                }}
                title="Tap to jump to the quoted text (or search by note)"
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                  }}
                >
                  <div style={{ fontWeight: 900, fontSize: 12, opacity: 0.8 }}>
                    {formatDate(a.createdAt)}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.65 }}>jump</div>
                </div>

                {a.quote ? (
                  <div
                    style={{
                      marginTop: 8,
                      padding: 10,
                      borderRadius: 14,
                      border: '1px solid rgba(255,255,255,0.10)',
                      background: 'rgba(0,0,0,0.20)',
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 900,
                        fontSize: 12,
                        opacity: 0.8,
                        marginBottom: 6,
                      }}
                    >
                      Quote
                    </div>
                    “{a.quote}”
                  </div>
                ) : null}

                <div style={{ marginTop: 10 }}>{a.note}</div>

                {a.imageUrls?.length ? (
                  <div
                    style={{
                      marginTop: 10,
                      display: 'grid',
                      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                      gap: 8,
                    }}
                  >
                    {a.imageUrls.map((u) => (
                      <img
                        key={u}
                        src={u}
                        alt="annotation"
                        style={{
                          width: '100%',
                          borderRadius: 14,
                          border: '1px solid rgba(255,255,255,0.10)',
                          objectFit: 'cover',
                          maxHeight: 220,
                        }}
                      />
                    ))}
                  </div>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function QuestionsChat({
  book,
  messages,
  onSend,
}: {
  book: Book | null;
  messages: ChatMessage[];
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  if (!book) {
    return (
      <div style={{ opacity: 0.85 }}>Choose a book to consult the oracle.</div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.length === 0 && (
          <div style={{ opacity: 0.75, fontSize: 13, lineHeight: '18px' }}>
            Ask about your campaign record.
            <br />
            The oracle only answers from transcript text.
            <br />
            If your question matches multiple moments, it will ask you to
            choose.
          </div>
        )}

        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '92%',
              padding: '10px 12px',
              borderRadius: 14,
              background:
                m.role === 'user'
                  ? 'rgba(255,255,255,0.10)'
                  : 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.08)',
              whiteSpace: 'pre-wrap',
              lineHeight: '18px',
              fontSize: 13,
            }}
          >
            {m.text}
          </div>
        ))}

        <div ref={endRef} />
      </div>

      <div style={{ marginTop: 'auto', paddingTop: 14 }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask the oracle… (tavern, woods, NPC, item, etc.)"
            style={{
              flex: 1,
              padding: '12px 12px',
              borderRadius: 14,
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(0,0,0,0.35)',
              color: '#fff',
              outline: 'none',
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const t = draft.trim();
                if (!t) return;
                onSend(t);
                setDraft('');
              }
            }}
          />
          <button
            style={{
              padding: '12px 14px',
              borderRadius: 14,
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(255,255,255,0.10)',
              color: '#fff',
              fontWeight: 900,
              cursor: 'pointer',
              userSelect: 'none',
            }}
            onClick={() => {
              const t = draft.trim();
              if (!t) return;
              onSend(t);
              setDraft('');
            }}
          >
            Ask
          </button>
        </div>
      </div>
    </div>
  );
}

function PlayAlong({
  chapter,
  paperBg,
  paperFg,
  onDeleteClip,
}: {
  chapter: Chapter | null;
  paperBg: string;
  paperFg: string;
  onDeleteClip: (clipIndex: number) => void;
}) {
  if (!chapter)
    return <div style={{ opacity: 0.85 }}>Open a chapter to play.</div>;
  const urls = chapter.audioUrls || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontWeight: 900 }}>{chapter.title}</div>

      <div
        style={{
          borderRadius: 16,
          padding: 14,
          background: paperBg,
          color: paperFg,
          border: '1px solid rgba(255,255,255,0.14)',
        }}
      >
        <div style={{ fontWeight: 900, marginBottom: 8 }}>Audio clips</div>

        {urls.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {urls.map((u, i) => (
              <div
                key={u}
                style={{
                  borderRadius: 14,
                  border: '1px solid rgba(0,0,0,0.12)',
                  padding: 10,
                  background: 'rgba(0,0,0,0.06)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    marginBottom: 8,
                  }}
                >
                  <div style={{ fontSize: 12, opacity: 0.8, fontWeight: 900 }}>
                    Clip {i + 1}
                  </div>
                  <button
                    style={{
                      padding: '8px 10px',
                      borderRadius: 12,
                      border: '1px solid rgba(0,0,0,0.18)',
                      background: 'rgba(0,0,0,0.08)',
                      cursor: 'pointer',
                      fontWeight: 900,
                    }}
                    onClick={() => onDeleteClip(i)}
                    aria-label={`Delete clip ${i + 1}`}
                    title="Delete this clip"
                  >
                    Delete
                  </button>
                </div>
                <audio src={u} controls style={{ width: '100%' }} />
              </div>
            ))}
          </div>
        ) : (
          <div style={{ opacity: 0.8, fontSize: 13 }}>
            No audio attached to this chapter yet.
          </div>
        )}
      </div>

      <div style={{ opacity: 0.75, fontSize: 12 }}>
        Tip: If you accidentally hit Stop too early, just record again — it’ll
        add another clip to this chapter.
      </div>
    </div>
  );
}

function RecordDrawer({
  open,
  onClose,
  book,
  recordMode,
  setRecordMode,
  showAppendOption,
  targetChapterTitle,
  isRecording,
  recSeconds,
  liveText,
  recError,
  onStart,
  onPause,
  onResume,
  onStop,
}: {
  open: boolean;
  onClose: () => void;
  book: Book | null;
  recordMode: RecordMode;
  setRecordMode: (m: RecordMode) => void;
  showAppendOption: boolean;
  targetChapterTitle: string | null;
  isRecording: boolean;
  recSeconds: number;
  liveText: string;
  recError: string | null;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}) {
  if (!open) return null;

  const mm = Math.floor(recSeconds / 60)
    .toString()
    .padStart(2, '0');
  const ss = Math.floor(recSeconds % 60)
    .toString()
    .padStart(2, '0');

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: APP_BG,
        zIndex: 95,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          padding: '14px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.10)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <button style={iconBtn()} onClick={onClose} aria-label="Close">
          ✕
        </button>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: 900 }}>Recording</div>
          <div style={{ opacity: 0.75, fontSize: 12 }}>
            {book ? book.title : 'Pick a book'}
          </div>
        </div>
        <div style={{ fontWeight: 900, minWidth: 56, textAlign: 'right' }}>
          {mm}:{ss}
        </div>
      </div>

      <div style={{ padding: 16, overflow: 'auto', flex: 1 }}>
        {showAppendOption && (
          <div
            style={{
              marginBottom: 12,
              padding: 12,
              borderRadius: 14,
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(0,0,0,0.22)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ fontWeight: 900 }}>Save to</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                style={{
                  ...primaryBtn(),
                  background:
                    recordMode === 'append' ? '#111' : 'rgba(255,255,255,0.10)',
                }}
                onClick={() => setRecordMode('append')}
              >
                This chapter
              </button>
              <button
                style={{
                  ...primaryBtn(),
                  background:
                    recordMode === 'new' ? '#111' : 'rgba(255,255,255,0.10)',
                }}
                onClick={() => setRecordMode('new')}
              >
                New chapter
              </button>
            </div>
            <div style={{ opacity: 0.8, fontSize: 12 }}>
              {recordMode === 'append'
                ? `Appending to: ${targetChapterTitle || 'Current chapter'}`
                : 'Will create a new chapter when you stop.'}
            </div>
          </div>
        )}

        {recError && (
          <div
            style={{
              marginBottom: 12,
              padding: 12,
              borderRadius: 14,
              border: '1px solid rgba(255,255,255,0.18)',
              background: 'rgba(0,0,0,0.25)',
            }}
          >
            <div style={{ fontWeight: 900, marginBottom: 4 }}>
              Mic / transcript error
            </div>
            <div style={{ opacity: 0.85, fontSize: 13 }}>{recError}</div>
          </div>
        )}

        <div
          style={{
            borderRadius: 18,
            border: '1px solid rgba(255,255,255,0.14)',
            padding: 14,
            background: 'rgba(0,0,0,0.22)',
            minHeight: 240,
            whiteSpace: 'pre-wrap',
            lineHeight: '20px',
            opacity: 0.95,
          }}
        >
          {liveText || '(Live transcript appears here while you record.)'}
        </div>
      </div>

      <div
        style={{
          padding: 14,
          borderTop: '1px solid rgba(255,255,255,0.10)',
          display: 'flex',
          gap: 10,
        }}
      >
        {!isRecording ? (
          <button style={primaryBtn()} onClick={onStart}>
            Start
          </button>
        ) : (
          <button style={ghostBtn()} onClick={onPause}>
            Pause
          </button>
        )}

        {!isRecording && recSeconds > 0 ? (
          <button style={primaryBtn()} onClick={onResume}>
            Resume
          </button>
        ) : (
          <div style={{ flex: 1 }} />
        )}

        <button
          style={{ ...primaryBtn(), background: 'rgba(255,255,255,0.14)' }}
          onClick={onStop}
        >
          Stop & Save
        </button>
      </div>
    </div>
  );
}

function stopAllRecording({
  mediaRecorderRef,
  mediaStreamRef,
  speechRef,
  recTimerRef,
  setIsRecording,
  setRecordOpen,
  setRecError,
}: {
  mediaRecorderRef: React.MutableRefObject<MediaRecorder | null>;
  mediaStreamRef: React.MutableRefObject<MediaStream | null>;
  speechRef: React.MutableRefObject<any>;
  recTimerRef: React.MutableRefObject<number | null>;
  setIsRecording: (b: boolean) => void;
  setRecordOpen?: (b: boolean) => void;
  setRecError?: (s: string | null) => void;
}) {
  try {
    mediaRecorderRef.current?.stop();
  } catch {}
  mediaRecorderRef.current = null;

  try {
    speechRef.current?.stop?.();
  } catch {}
  speechRef.current = null;

  if (recTimerRef.current) {
    try {
      window.clearInterval(recTimerRef.current);
    } catch {}
    recTimerRef.current = null;
  }

  if (mediaStreamRef.current) {
    try {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
    } catch {}
    mediaStreamRef.current = null;
  }

  setIsRecording(false);
  setRecError?.(null);
  setRecordOpen?.(false);
}

function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 90,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 520,
          background: '#fff',
          color: '#111',
          borderRadius: 16,
          padding: 16,
          boxShadow: '0 18px 46px rgba(0,0,0,0.45)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <div style={{ fontWeight: 900 }}>{title}</div>
          <button
            style={iconBtn('#111', 'rgba(0,0,0,0.08)')}
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div style={{ marginTop: 12 }}>{children}</div>
      </div>
    </div>
  );
}

function ConfirmModal({
  open,
  title,
  body,
  confirmText,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmText: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 99,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 520,
          background: '#111',
          color: '#fff',
          borderRadius: 16,
          padding: 16,
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 18px 46px rgba(0,0,0,0.55)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 900, fontSize: 16 }}>{title}</div>
        <div style={{ marginTop: 8, opacity: 0.85, lineHeight: '18px' }}>
          {body}
        </div>

        <div
          style={{
            marginTop: 14,
            display: 'flex',
            gap: 10,
            justifyContent: 'flex-end',
          }}
        >
          <button style={ghostBtn()} onClick={onCancel}>
            Cancel
          </button>
          <button
            style={{
              ...primaryBtn(),
              background: 'rgba(255,255,255,0.14)',
              border: '1px solid rgba(255,255,255,0.18)',
            }}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
